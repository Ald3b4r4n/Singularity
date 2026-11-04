'use strict';

function parseVersion(value) {
	const version = String(value);
	const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/.exec(version);
	if (!match || match[0] !== version || match.slice(1).some(n => n !== undefined && Number(n) > 65535)) {
		return undefined;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}

function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) {
		const error = new Error('invalid Singularity release version');
		error.code = 'bad-version';
		throw error;
	}
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) {
			return left[i] < right[i] ? -1 : 1;
		}
	}
	return 0;
}

module.exports = { parseVersion, compareVersions };
