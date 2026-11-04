'use strict';
// Pure helpers for the model choice that travels from the panel to the Hub. No VS Code dependency, so they are tested alone.

const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

/** The model choice from the webview, reduced to the strings the Hub validates against the real catalog. */
function selectionOf(value) {
	if (!value || typeof value !== 'object') { return undefined; }
	const providerID = text(value.providerID, 160);
	const modelID = text(value.modelID, 160);
	const variant = value.variant === undefined || value.variant === '' ? undefined : text(value.variant, 24);
	return providerID && modelID ? { providerID, modelID, ...(variant ? { variant } : {}) } : undefined;
}

/** Whether two choices (or a session's reported model and a choice) are the same model at the same effort. */
const same = (a, b) => !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID && (a.variant || '') === (b.variant || '');

module.exports = { selectionOf, same, text };
