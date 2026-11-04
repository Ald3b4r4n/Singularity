'use strict';

const { parseVersion } = require('../../extensions/singularity-update/version.js');

// Windows version resources need numeric components. The display version keeps
// the complete SemVer, including any Preview identifier.
function parseWindowsProductVersion(version) {
	const parsed = parseVersion(version);
	if (!parsed || version.startsWith('v')) {
		throw new Error(`Invalid Singularity product version: ${version}`);
	}
	const [major, minor, patch, preview] = parsed;
	return `${major}.${minor}.${patch}.${Number.isFinite(preview) ? preview : 0}`;
}

module.exports = { parseWindowsProductVersion };
