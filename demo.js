// Bee Talk demo data shared by the demo app (index.html without an event) and the demo panel (admin.html?demo=1).
// Both pages read and write the same localStorage keys on this device, so the made-up guests, their ids and the
// nightly 1:00 cut-off must be defined once, here. Classic script: it adds one global, DemoShared.
const DemoShared = (() => {
  // ─── Constants ───
  /* tt_demo_made_v1 = attendees the visitor made { cur, list }, tt_demo_seq = next made-attendee id, tt_demo_removed = fictional guests
     removed in the panel { ids, at }, tt_demo_cphoto (+ _at) = couple photo ('' cartoon, a data URL, 'none' or 'declined'),
     tt_demo_event = names and date line changed in the panel, tt_mock_messages_v1 = demo chats, tt_demo_avatar = the visitor's photo. */
  const KEYS = { made: 'tt_demo_made_v1', seq: 'tt_demo_seq', removed: 'tt_demo_removed', photo: 'tt_demo_cphoto', photoAt: 'tt_demo_cphoto_at', event: 'tt_demo_event', msgs: 'tt_mock_messages_v1', avatar: 'tt_demo_avatar' };
  // the fictional guests; their index is their id, and the couple come right after them
  const NAMES = ['Zosia W.', 'Piotr K.', 'Kasia M.', 'Tomek B.', 'Magda L.', 'Bartek N.', 'Ewa R.', 'Jakub S.', 'Natalia P.', 'Michał D.', 'Agnieszka T.', 'Paweł G.', 'Ida F.', 'Kuba Z.', 'Marta C.', 'Szymon H.', 'Julia O.', 'Adam V.', 'Karolina J.', 'Filip A.', 'Basia E.', 'Olek Y.'];
  // the couple use the app too: Ania & Marek answer like any other guest (side = their own side, relation = family)
  const COUPLE = [
    { couple: 'bride', name: 'Ania W.', first: 'Ania', answers: [0, 1, 3, 0, [0, 9], 0, 0, 0, 4, 3] },
    { couple: 'groom', name: 'Marek W.', first: 'Marek', answers: [1, 1, 3, 0, [1, 2], 2, 1, 4, 0, 4] },
  ];
  const ANSWERS = 10;   // number of questions (Q.length in index.html)

  // ─── Helpers ───
  const store = {   // localStorage that never throws; set(k, null) removes, set returns false when storage is full or blocked
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    json(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; } catch (e) { return d; } },
  };
  const oneAm = next => { const d = new Date(); d.setHours(1, 0, 0, 0); if (next ? d <= new Date() : d > new Date()) d.setDate(d.getDate() + (next ? 1 : -1)); return d.getTime(); };   // the last / the next 1:00, when demo data is cleared
  const okAttendee = (x, cut = oneAm(false)) => !!x && typeof x.name === 'string' && !!x.name && Array.isArray(x.answers) && x.answers.length === ANSWERS && x.at >= cut;   // made before the last 1:00: gone
  const removedIds = (cut = oneAm(false)) => { const rm = store.json(KEYS.removed, {}) || {}; return rm.at >= cut && Array.isArray(rm.ids) ? rm.ids : []; };
  const toDataUrl = blob => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(blob); });

  return { KEYS, NAMES, COUPLE, ANSWERS, store, oneAm, okAttendee, removedIds, toDataUrl };
})();
