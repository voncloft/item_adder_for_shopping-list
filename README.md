# Walmart Food Import Helper

Firefox extension, version 1.2.

Load this folder's `manifest.json` as a temporary Firefox extension.

The popup reads the current Walmart page, pre-fills the same fields used by
`php/add_foods.php`, and POSTs them to `scripts/add_food_to_db.php`.

Default server settings:

- Base URL: `http://voncloft.shopping.com`
- Endpoint: `/scripts/add_food_to_db.php`

The extension submits `format=json` so the PHP script can return a clean success
or error response without changing the normal browser form workflow.
# item_adder_for_shopping-list

Run `python3 build-extension.py` to build `walmart_food_import_helper-1.2.xpi`.
Reload the temporary add-on (or reinstall the XPI) and reload Walmart tabs to use
the update. Building does not change the installed Firefox copy.

## Aisle formatting

Single-digit aisle codes are padded before display and submission: `A9` becomes
`A09`, and `A1` becomes `A01`. Codes such as `A22` and `A09` stay unchanged.
The rule also covers typed values and remembered departments. Category names
such as `Dairy`, numeric-only aisles, and shelf codes such as `A9-2` stay intact.

## Food and non-food items

Food products keep their Walmart calories, protein, fat, carbohydrates, fiber,
and the existing serving behavior. The on-page panel still uses Open Food Facts
when food nutrition is incomplete. Missing food nutrition is not assumed to be zero.

Non-food products are detected from Walmart categories/product types and clear
product descriptions. Calories, protein, fat, carbohydrates, fiber, and servings
default to numeric zero, including in the final server request. Non-food products
skip Open Food Facts so a similarly named food cannot supply their nutrition.

Both the popup and the on-page panel include **Non-food item — zero nutrition**
for correcting missing or incorrect category data. Clearing it restores the food
values so they can be edited. Product name, price, department, and URL are retained.

Run `node --test tests/*.test.cjs` for the extraction, form, and submission checks.
