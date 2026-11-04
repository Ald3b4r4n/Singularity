'use strict';

// Windows version resources need numeric components. The display version keeps
// the complete SemVer, including any Preview identifier.
function parseWindowsProductVersion(version) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
	if (!match || match.slice(1).some(component => component !== undefined && Number(component) > 65535)) {
		throw new Error(`Invalid Singularity product version: ${version}`);
	}
	return `${match[1]}.${match[2]}.${match[3]}.${match[4] ?? 0}`;
}

module.exports = { parseWindowsProductVersion };
