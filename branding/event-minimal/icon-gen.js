(function (root) {
  var n = 0;

  function params(size) {
    if (size >= 48) return { sw: 8, ry: 6, rx: 112, r: 60, halo: true, border: true };
    if (size >= 32) return { sw: 14, ry: 9, rx: 116, r: 76, halo: false, border: true };
    if (size >= 24) return { sw: 18, ry: 11, rx: 118, r: 82, halo: false, border: false };
    return { sw: 24, ry: 14, rx: 120, r: 90, halo: false, border: false };
  }

  function icon(o) {
    var size = o.size || 256;
    var kind = o.kind || 'tile';
    var mode = o.mode || 'dark';
    var dark = mode === 'dark';
    var p = params(size);
    var u = 'em' + (++n);
    var ring = dark ? ['#FFE2B0', '#FFB45E', '#FF6A3D'] : ['#E8923A', '#D9730D', '#B4430B'];
    var disc = dark ? ['#FFB45E', '#FFEBC9', '#FF7A45'] : ['#D9730D', '#F2B97A', '#B4430B'];
    var mono = kind === 'mono';
    var c = o.color || '#FFFFFF';
    var out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 256 256" role="img" aria-label="Singularity IDE">';
    if (!mono) {
      out += '<defs>' +
        '<linearGradient id="r' + u + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + ring[0] + '"/><stop offset=".5" stop-color="' + ring[1] + '"/><stop offset="1" stop-color="' + ring[2] + '"/></linearGradient>' +
        '<linearGradient id="d' + u + '" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + disc[0] + '" stop-opacity="0"/><stop offset=".22" stop-color="' + disc[0] + '"/><stop offset=".5" stop-color="' + disc[1] + '"/><stop offset=".78" stop-color="' + disc[2] + '"/><stop offset="1" stop-color="' + disc[2] + '" stop-opacity="0"/></linearGradient>' +
        '<radialGradient id="h' + u + '" cx="50%" cy="50%" r="50%"><stop offset=".5" stop-color="#FFB45E" stop-opacity="0"/><stop offset=".74" stop-color="#FFB45E" stop-opacity=".2"/><stop offset="1" stop-color="#FFB45E" stop-opacity="0"/></radialGradient>' +
        '</defs>';
    }
    if (kind === 'tile') {
      out += '<rect width="256" height="256" rx="56" fill="' + (dark ? '#07080C' : '#F6F3EC') + '"/>';
      if (p.border) out += '<rect x="2" y="2" width="252" height="252" rx="54" fill="none" stroke="' + (dark ? '#262A36' : '#D9D3C5') + '" stroke-width="4"/>';
    }
    if (!mono && p.halo && dark) out += '<circle cx="128" cy="128" r="118" fill="url(#h' + u + ')"/>';
    var core = dark ? '#000000' : '#07080C';
    if (mono) {
      out += '<circle cx="128" cy="128" r="' + p.r + '" fill="none" stroke="' + c + '" stroke-width="' + p.sw + '"/>';
      out += '<g transform="rotate(-14 128 128)"><ellipse cx="128" cy="128" rx="' + p.rx + '" ry="' + p.ry + '" fill="' + c + '"/></g>';
    } else {
      out += '<circle cx="128" cy="128" r="' + p.r + '" fill="' + core + '" stroke="url(#r' + u + ')" stroke-width="' + p.sw + '"/>';
      out += '<g transform="rotate(-14 128 128)"><ellipse cx="128" cy="128" rx="' + p.rx + '" ry="' + p.ry + '" fill="url(#d' + u + ')"/></g>';
    }
    return out + '</svg>';
  }

  var api = { icon: icon, params: params };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EM = api;
})(typeof window !== 'undefined' ? window : this);
