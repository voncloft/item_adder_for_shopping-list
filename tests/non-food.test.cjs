'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = name => readFileSync(path.join(__dirname, '..', name), 'utf8');
function shared(extra = {}) {
  const context = { URL, URLSearchParams, ...extra };
  vm.runInNewContext(source('nutrition.js'), context);
  return context;
}
function background() {
  let listener;
  const requests = [];
  const local = { async get(defaults) { return defaults; }, async set() {} };
  const context = shared({
    browser: { storage: { local }, runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    async fetch(url, options) {
      requests.push({ url, ...options });
      return { ok: true, status: 200, async text() { return '{"ok":true,"insert_id":17}'; } };
    }
  });
  vm.runInNewContext(source('background.js'), context);
  return { requests, local, send: message => listener(message, {}) };
}
class Element {
  constructor() { this.value=''; this.checked=false; this.style={}; this.dataset={}; this.listeners={}; this.classList={add(){}}; }
  addEventListener(event, fn) { this.listeners[event]=fn; }
  removeAttribute() {}
}
function panel() {
  const messages = [];
  const context = shared({
    location: { hostname:'www.walmart.com', href:'https://www.walmart.com/ip/Item/123' },
    browser: {runtime: {onMessage:{addListener(){}}, async sendMessage(message) { messages.push(message); return {ok:true,json:{status:0,products:[]}}; }}}
  });
  const marker='  installWalmartImportPanel();';
  vm.runInNewContext(source('content-script.js').replace(marker,
    'globalThis.panelTest = { readPanelForm, renderPanelData, lookupFallbackNutrition, extractFromProductData, extractFromJsonLd, buildResponse, setPanel(value) { panelElements = value; } };'), context);
  const fields=Object.fromEntries(['nonFood','item','price','dept','itemId','servings','protein','fat','carbs','calories','fiber','url','sourceRow','sourceLink'].map(key=>[key,new Element()]));
  context.panelTest.setPanel(fields);
  return {api:context.panelTest, helper:context.WalmartNutrition, fields, messages};
}
const food={servings:'4',calories:'130',protein:'8',fat:'5',carbs:'12',fiber:'0'};
const nutrients=Object.keys(food);
const examples = [
  ['Laundry detergent', ['Household Essentials','Laundry'], true],
  ['Cotton T-Shirt', ['Clothing','Mens Shirts'], true],
  ['Dining Table', ['Home','Furniture'], true],
  ['Notebook', ['Office Supplies'], true],
  ['Television', ['Electronics','Televisions'], true],
  ['Toothpaste', ['Personal Care','Oral Care'], true],
  ['Tennis Balls', ['Sports & Outdoors'], true],
  ['Dog Food', ['Pets','Dog Food'], true],
  ['Floor Lamp', ['Home','Home Decor'], true],
  ['Paper Towels', [], true],
  ['All Purpose Flour', ['Food','Baking'], false],
  ['Milk', ['Food','Dairy'], false],
  ['Apples', ['Produce'], false],
  ['TV Dinner', ['Frozen Food','TV Dinners'], false],
  ['Chicken Soup', ['Grocery','Pantry'], false],
  ['Dough Conditioner', ['Food','Baking'], false],
  ['Protein Powder', ['Health','Protein Powders'], false],
  ['Infant Formula', ['Baby Care','Infant Formula'], false],
  ['Mystery Item', [], false],
  ['Milk', ['Home'], false]
];
for (const [title,categories,nonFood] of examples) {
  test(`classification: ${title}`, () => {
    assert.equal(shared().WalmartNutrition.isNonFood({title,categories,nutrition:{}}), nonFood);
  });
}
test('product categories survive aisle extraction and JSON-LD extraction', () => {
  const {api,helper}=panel();
  const root={querySelectorAll(){return [];},body:{innerText:''}};
  const product={name:'Laundry detergent',priceInfo:{currentPrice:{price:12}},aisle:'A9',category:{path:[{name:'Household Essentials'},{name:'Laundry'}]}};
  const data=api.extractFromProductData({props:{pageProps:{initialData:{data:{product}}}}},'https://www.walmart.com/ip/123','Item',root);
  const result=api.buildResponse(data,'https://www.walmart.com/ip/123','Item',root);
  assert.ok(result.categories.includes('Household Essentials'));
  assert.equal(helper.isNonFood({...result,department:'A09'}),true);
  const ld={'@type':'Product',name:'T-Shirt',category:'Clothing',offers:{price:9}};
  const ldRoot={querySelectorAll(selector){return selector.startsWith('script')?[{textContent:JSON.stringify(ld)}]:[];}};
  assert.equal(helper.isNonFood(api.extractFromJsonLd(ldRoot,'https://www.walmart.com/ip/123','Item')),true);
});
test('non-food panel shows zeros and posts every nutrition field as numeric zero', async () => {
  const {api,fields}=panel();
  api.renderPanelData({title:'Laundry detergent',price:'12.50',department:'A9',categories:['Household Essentials'],nutrition:food},'');
  assert.equal(fields.nonFood.checked,true);
  for(const key of nutrients) { assert.equal(fields[key].value,'0'); assert.equal(fields[key].readOnly,true); }
  fields.protein.value='not numeric'; // The submission guard must still force zero.
  const bg=background();
  await bg.send({type:'submitFoodInsert',form:api.readPanelForm()});
  const posted=new URLSearchParams(bg.requests[0].body);
  for(const key of nutrients) assert.equal(posted.get(key),'0',key);
  assert.equal(posted.get('item'),'Laundry detergent');
  assert.equal(posted.get('price'),'12.50');
  assert.equal(posted.get('dept'),'A09');
  assert.equal(posted.has('nonFood'),false,'internal flag is not added to the PHP contract');
});
test('food panel retains calories/macros and the existing seven-serving default', async () => {
  const {api,fields}=panel();
  api.renderPanelData({title:'Milk',price:'3.25',categories:['Food','Dairy'],nutrition:food},'');
  assert.equal(fields.nonFood.checked,false);
  const form=api.readPanelForm();
  assert.equal(form.servings,'7');
  for(const key of nutrients.filter(k=>k!=='servings')) assert.equal(form[key],food[key],key);
  const bg=background(); await bg.send({type:'submitFoodInsert',form});
  const posted=new URLSearchParams(bg.requests[0].body);
  assert.equal(posted.get('calories'),'130'); assert.equal(posted.get('protein'),'8');
});
test('missing food nutrition still uses the normal fallback; non-food never queries it', async () => {
  const {api,messages,fields}=panel();
  const nonFood={title:'Notebook',categories:['Office Supplies'],barcode:'012345678901'};
  assert.equal(await api.lookupFallbackNutrition(nonFood),null);
  assert.equal(messages.length,0);
  api.renderPanelData({title:'Apples',price:'2.00',categories:['Produce'],nutrition:{}},'');
  assert.equal(fields.calories.value,'');
  await api.lookupFallbackNutrition({title:'Apples',categories:['Produce']});
  assert.equal(messages[0].type,'searchOpenFoodFacts');
});
test('manual non-food toggle zeros then restores food nutrition without touching price', () => {
  const {api,fields,helper}=panel();
  api.renderPanelData({title:'Milk',price:'3.25',nutrition:food},'');
  fields.nonFood.checked=true; helper.toggleFields(fields);
  for(const key of nutrients) assert.equal(fields[key].value,'0');
  fields.nonFood.checked=false; helper.toggleFields(fields);
  assert.equal(fields.calories.value,'130'); assert.equal(fields.protein.value,'8');
  assert.equal(fields.servings.value,'7'); assert.equal(fields.price.value,'3.25');
});
test('background enforces non-food zeros without mutating the caller', async () => {
  const bg=background();
  const form={item:'Shirt',price:'9.00',nonFood:true,...food};
  await bg.send({type:'submitFoodInsert',form});
  const posted=new URLSearchParams(bg.requests[0].body);
  for(const key of nutrients) assert.equal(posted.get(key),'0');
  assert.equal(form.protein,'8'); assert.equal(form.nonFood,true);
});
test('popup automatically zeros non-food, then restores food values on the next product', async () => {
  const bg=background(), nodes={};
  let data={ok:true,title:'Notebook',price:'2.50',categories:['Office Supplies'],nutrition:{},url:'https://www.walmart.com/ip/123'};
  const context=shared({
    document:{getElementById(id){return nodes[id] ||= new Element();}},
    browser:{storage:{local:bg.local},runtime:{getManifest:()=>({version:'1.2'}),sendMessage:bg.send,openOptionsPage(){}},
      tabs:{async query(){return [{id:1,url:data.url}];},async sendMessage(){return data;}}}
  });
  vm.runInNewContext(source('popup.js'),context);
  for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nodes.nonFood.checked,true);
  await nodes.saveCurrent.listeners.click();
  const posted=new URLSearchParams(bg.requests[0].body);
  for(const key of nutrients) assert.equal(posted.get(key),'0');
  data={...data,title:'Milk',categories:['Food','Dairy'],nutrition:food};
  await nodes.refresh.listeners.click();
  assert.equal(nodes.nonFood.checked,false);
  assert.equal(nodes.calories.value,'130'); assert.equal(nodes.protein.value,'8');
  assert.equal(nodes.servings.value,'4');
});
