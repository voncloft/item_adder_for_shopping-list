'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = name => readFileSync(path.join(__dirname, '..', name), 'utf8');
function storage() {
  const data = {};
  return { data, async get(defaults) { return { ...defaults, ...data }; }, async set(values) { Object.assign(data, values); } };
}
function background() {
  let listener;
  const requests = [];
  const local = storage();
  vm.runInNewContext(source('nutrition.js') + '\n' + source('background.js'), {
    URL, URLSearchParams,
    browser: { storage: { local }, runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    async fetch(url, options) {
      requests.push({ url, ...options });
      return { ok: true, status: 200, async text() { return '{"ok":true,"insert_id":991}'; } };
    }
  });
  return { requests, send: message => listener(message, {}), local };
}
const cases = [['A9','A09'], ['A1','A01'], ['A22','A22'], ['A09','A09'], ['a99','a99'], [' b9 ','b09'], ['A0','A00'], ['A9-2','A9-2'], ['A9B','A9B'], ['9','9'], ['Dairy','Dairy'], ['','']];
for (const [dept, expected] of cases) {
  test(`food insert submits ${JSON.stringify(dept)} correctly`, async () => {
    const bg = background();
    const form = { item: 'Milk', price: '3.25', dept, calories: '120', url: 'https://www.walmart.com/ip/Milk/123' };
    const response = await bg.send({ type: 'submitFoodInsert', form });
    assert.equal(response.ok, true);
    assert.equal(bg.requests.length, 1);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(bg.requests[0].body)), { ...form, dept: expected, format: 'json' });
    assert.equal(form.dept, dept, 'request normalization does not mutate the caller');
  });
}
class Element {
  constructor() { this.value=''; this.style={}; this.listeners={}; this.classList={ add() {} }; }
  addEventListener(event, fn) { this.listeners[event]=fn; }
  removeAttribute() {}
}
const settle = async () => { for(let i=0;i<8;i++) await new Promise(resolve=>setImmediate(resolve)); };
test('popup normalizes detected, remembered, and manually typed aisle values', async () => {
  const bg=background();
  const nodes={};
  const data={ok:true,title:'Milk',price:'3.25',itemId:'123',department:'A9',nutrition:{},url:'https://www.walmart.com/ip/Milk/123'};
  vm.runInNewContext(source('nutrition.js') + '\n' + source('popup.js'), {
    URL, document:{getElementById(id) { return nodes[id] ||= new Element(); }},
    browser:{
      storage:{local:bg.local}, runtime:{getManifest:()=>JSON.parse(source('manifest.json')),sendMessage:bg.send,openOptionsPage(){}},
      tabs:{async query(){return [{id:1,url:data.url}];},async sendMessage(){return {...data};}}
    }
  });
  await settle(); assert.equal(nodes.dept.value,'A09');
  nodes.dept.value='A1'; await nodes.saveCurrent.listeners.click();
  assert.equal(new URLSearchParams(bg.requests[0].body).get('dept'),'A01');
  assert.equal(bg.local.data.lastDepartment,'A01');
  data.department=null; bg.local.data.lastDepartment='A9';
  await nodes.refresh.listeners.click(); assert.equal(nodes.dept.value,'A09');
});
test('on-page panel normalizes aisle extraction and form submission while keeping categories', async () => {
  // Expose the real panel functions without installing browser UI during this test.
  const marker='  installWalmartImportPanel();';
  const code=source('content-script.js');
  assert.equal(code.split(marker).length,2);
  const context={URL,URLSearchParams,location:{hostname:'www.walmart.com',href:'https://www.walmart.com/ip/Milk/123'},
    browser:{runtime:{onMessage:{addListener(){}}}}};
  vm.runInNewContext(source('nutrition.js') + '\n' + code.replace(marker,'globalThis.panelTest = { extractAisleCode, readPanelForm, renderPanelData, setPanel(value) { panelElements = value; } };'),context);
  const api=context.panelTest;
  for(const [input,expected] of [['Aisle A9','A09'],['In A1 aisle','A01'],['Location: A22','A22'],['A09','A09'],['A9-2','A9-2'],['Dairy',null]]) {
    assert.equal(api.extractAisleCode(input),expected);
  }
  const fields=Object.fromEntries(['nonFood','item','price','dept','itemId','servings','protein','fat','carbs','calories','fiber','url','sourceRow','sourceLink'].map(key=>[key,new Element()]));
  api.setPanel(fields);
  api.renderPanelData({title:'Milk',price:'3.25',department:'A9'},'');
  assert.equal(fields.dept.value,'A09');
  fields.dept.value='A1';
  const form=api.readPanelForm(); assert.equal(form.dept,'A01');
  const bg=background(); await bg.send({type:'submitFoodInsert',form});
  assert.equal(new URLSearchParams(bg.requests[0].body).get('dept'),'A01');
  api.renderPanelData({title:'Milk',price:'3.25'},'A9');
  assert.equal(fields.dept.value,'A09');
  fields.dept.value='Dairy'; assert.equal(api.readPanelForm().dept,'Dairy');
});
