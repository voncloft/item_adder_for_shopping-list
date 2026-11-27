# Changelog

## 1.2

- Automatically zero all nutrition fields for non-food items in both import interfaces and the final POST.
- Keep food nutrition extraction and fallback lookups; do not treat missing food data as zero.
- Skip food-database searches for non-food products.
- Add a non-food checkbox for correcting incomplete category data, with restoration of food values.
- Preserve the existing aisle normalization, extension name, and Gecko ID.

## 1.1

- Pad single-digit aisle numbers before display and server submission (A9 → A09).
- Preserve existing two-digit aisle numbers, already-padded codes, and shelf suffixes.
