/* state.js — serialise a module's settings for share links, files and autosave.
   Transport only: validation of the decoded values is the module's job, since a
   shared link is untrusted input. Every payload carries the module id and a
   format version so links keep working after the site is reorganised. */
(function (g) {
  'use strict';

  const PREFIX = 's=';

  function toB64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64Url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  const State = {
    encode: function (obj) { return toB64Url(JSON.stringify(obj)); },

    decode: function (str) {
      try {
        const obj = JSON.parse(fromB64Url(str));
        return obj && typeof obj === 'object' ? obj : null;
      } catch (e) { return null; }
    },

    /* state carried in the URL fragment, or null */
    fromHash: function () {
      const h = (g.location.hash || '').replace(/^#/, '');
      if (h.indexOf(PREFIX) !== 0) return null;
      return State.decode(h.slice(PREFIX.length));
    },

    shareUrl: function (obj) {
      return g.location.origin + g.location.pathname + '#' + PREFIX + State.encode(obj);
    },

    writeHash: function (obj) {
      const url = State.shareUrl(obj);
      try { history.replaceState(null, '', url); } catch (e) { }
      return url;
    },

    copy: function (text) {
      if (navigator.clipboard && g.isSecureContext) return navigator.clipboard.writeText(text);
      return Promise.reject(new Error('clipboard unavailable'));
    },

    save: function (key, obj) {
      try { localStorage.setItem(key, JSON.stringify(obj)); return true; } catch (e) { return false; }
    },
    load: function (key) {
      try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
    },
    clear: function (key) {
      try { localStorage.removeItem(key); } catch (e) { }
    },

    readFile: function (file) {
      return file.text().then(function (t) {
        const obj = JSON.parse(t);
        if (!obj || typeof obj !== 'object') throw new Error('not a state file');
        return obj;
      });
    }
  };

  g.AM.State = State;
})(window);
