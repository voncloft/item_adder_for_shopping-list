"use strict";

const browserApi = typeof browser !== "undefined"
  ? browser
  : (typeof chrome !== "undefined" ? chrome : null);
const SETTINGS_KEY = "serverSettings";

const elements = {
  version: document.getElementById("version"),
  status: document.getElementById("status"),
  serverBaseUrl: document.getElementById("serverBaseUrl"),
  addEndpoint: document.getElementById("addEndpoint"),
  saveSettings: document.getElementById("saveSettings"),
  resetSettings: document.getElementById("resetSettings")
};

if (!browserApi) {
  throw new Error("Browser extension API is not available.");
}

elements.version.textContent = `v${browserApi.runtime.getManifest().version}`;

function getDefaultSettings() {
  return {
    serverBaseUrl: "http://voncloft.shopping.com",
    addEndpoint: "/scripts/add_food_to_db.php"
  };
}

function setStatus(message, tone) {
  elements.status.textContent = message;
  elements.status.className = "status";
  if (tone) {
    elements.status.classList.add(tone);
  }
}

function readForm() {
  return {
    serverBaseUrl: elements.serverBaseUrl.value.trim(),
    addEndpoint: elements.addEndpoint.value.trim()
  };
}

function writeForm(settings) {
  elements.serverBaseUrl.value = settings.serverBaseUrl || "";
  elements.addEndpoint.value = settings.addEndpoint || "";
}

function buildServerUrl(settings) {
  if (!settings.serverBaseUrl || !settings.addEndpoint) {
    throw new Error("Server URL and add endpoint are required.");
  }

  return new URL(settings.addEndpoint, settings.serverBaseUrl).toString();
}

async function saveSettings() {
  const settings = readForm();
  const fullUrl = buildServerUrl(settings);
  await browserApi.storage.local.set({ [SETTINGS_KEY]: settings });
  setStatus(`Saved ${fullUrl}`, "good");
}

function resetSettings() {
  writeForm(getDefaultSettings());
  setStatus("Defaults restored in the form. Click Save Settings to apply them.", "good");
}

async function init() {
  const stored = await browserApi.storage.local.get({ [SETTINGS_KEY]: getDefaultSettings() });
  writeForm(stored[SETTINGS_KEY]);
}

elements.saveSettings.addEventListener("click", () => {
  saveSettings().catch((error) => {
    setStatus(error.message || String(error), "bad");
  });
});

elements.resetSettings.addEventListener("click", resetSettings);

init().catch((error) => {
  setStatus(error.message || String(error), "bad");
});
