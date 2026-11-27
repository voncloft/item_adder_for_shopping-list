"use strict";

// Shared by extraction, both forms, and the final POST boundary.
(function () {
  const fields = ["servings", "calories", "protein", "fat", "carbs", "fiber"];
  const labels = { servings: "Servings", calories: "Calories", protein: "Protein",
    fat: "Fat", carbs: "Carbohydrates", fiber: "Fiber" };

  function categoryLabels(product) {
    const result = [];
    function add(value, depth = 0) {
      if (depth > 5 || value == null) return;
      if (typeof value === "string") result.push(value);
      else if (Array.isArray(value)) value.slice(0, 100).forEach(entry => add(entry, depth + 1));
      else if (typeof value === "object") {
        for (const key of ["name", "title", "label", "displayName", "path", "categoryPath", "item"])
          add(value[key], depth + 1);
      }
    }
    for (const key of ["category", "categoryPath", "breadcrumbs", "productType", "productTypeName", "typeName"])
      add(product?.[key]);
    return [...new Set(result)];
  }

  function words(value) {
    return String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  const nonFoodCategory = /\b(?:electronics|televisions?|tvs|tv video|computers?|laptops?|cell phones?|video games?|cameras?|audio equipment|home theater|household essentials|household supplies|cleaning supplies|laundry|paper plastic|paper goods|personal care|beauty|hair care|skin care|oral care|feminine care|diapers?|baby care|pet supplies|pets|dog food|cat food|automotive|auto parts|tires|hardware|home improvement|tools|furniture|bedding|bath linens|home decor|kitchen dining|cookware|bakeware|dinnerware|appliances|clothing|apparel|shoes|jewelry|toys|office supplies|school supplies|arts crafts|sporting goods|sports outdoors|lawn garden|patio garden)\b/;
  const foodCategory = /\b(?:food|grocery|groceries|beverages|drinks|dairy|produce|meat|seafood|bakery|baking|snacks|candy|cereal|frozen foods|pantry|condiments|spices|protein powders|nutrition shakes|baby food|infant formula)\b/;
  // Title fallback is deliberately specific. Missing nutrition alone is never
  // evidence that a product is non-food (e.g. fresh produce or incomplete labels).
  const nonFoodTitle = /\b(?:smart tv|roku tv|google tv|fire tv|oled tv|qled tv|uhd tv|led tv|lcd tv|television|hdtv|laptop|chromebook|computer monitor|smartphone|headphones?|earbuds?|soundbar|bluetooth speaker|gaming console|paper towels?|toilet paper|toilet tissue|facial tissues?|trash bags?|garbage bags?|paper plates?|plastic cutlery|aluminum foil|food storage bags?|laundry detergent|dishwasher (?:detergent|pods|tablets)|dish soap|hand soap|body wash|shampoo|hair conditioner|fabric softener|dryer sheets?|disinfectant wipes?|disinfectant spray|toilet bowl cleaner|glass cleaner|all purpose cleaner|toothpaste|toothbrush|dental floss|deodorant|razors?|body lotion|diapers?|baby wipes?|tampons?|sanitary pads?|cotton swabs?|bandages?|cat litter|dog food|cat food|pet food|light bulbs?|led bulbs?|alkaline batteries|aa batteries|aaa batteries|motor oil|wiper blades?)\b/;

  function isNonFood(data) {
    const categories = words([...(data?.categories || []), data?.department || ""].join(" "));
    if (/\b(?:baby food|infant formula|protein powders|nutrition shakes|meal replacements|tv dinners)\b/.test(categories)) return false;
    if (nonFoodCategory.test(categories)) return true;
    // Keep real food in grocery categories, even when its name has an ambiguous
    // household term. TV dinners, for example, are still food.
    if (foodCategory.test(categories)) return false;
    return nonFoodTitle.test(words(data?.title));
  }

  function renderFields(elements, nutrition, nonFood, defaultServings = "") {
    elements.nonFood.checked = nonFood;
    elements.nutritionBeforeNonFood = {};
    for (const field of fields) {
      const value = field === "servings" && defaultServings !== ""
        ? defaultServings : String(nutrition?.[field] ?? "");
      elements.nutritionBeforeNonFood[field] = value;
      elements[field].value = nonFood ? "0" : value;
      elements[field].readOnly = nonFood;
    }
  }

  function toggleFields(elements) {
    const nonFood = elements.nonFood.checked;
    if (nonFood) {
      elements.nutritionBeforeNonFood = Object.fromEntries(fields.map(field => [field, elements[field].value]));
    }
    for (const field of fields) {
      elements[field].value = nonFood ? "0" : elements.nutritionBeforeNonFood?.[field] ?? "";
      elements[field].readOnly = nonFood;
    }
  }

  function readFields(elements, normalize) {
    const nonFood = elements.nonFood.checked;
    return { nonFood, ...Object.fromEntries(fields.map(field =>
      [field, nonFood ? "0" : normalize(elements[field].value, labels[field])])) };
  }

  function forSubmission(form) {
    const result = { ...form };
    if (form?.nonFood === true) {
      for (const field of fields) result[field] = "0";
    }
    delete result.nonFood;
    return result;
  }

  globalThis.WalmartNutrition = Object.freeze({
    fields, categoryLabels, isNonFood, renderFields, toggleFields, readFields, forSubmission
  });
})();
