/* Sets the day/night class and the browser colour BEFORE the first paint (no flash of the wrong theme). Same rule as js/theme.js (which keeps the page right
 * afterwards): the saved Day/Night choice, otherwise the schedule synced from the desktop app, otherwise 22:00-06:00. It does not depend on any other
 * script: if vendor/theme-schedule.js is missing the inline rule below gives the identical answer. */
(function () {
  var v = null; try { v = localStorage.getItem('petali-id-theme'); } catch (e) { /* storage unavailable */ }
  var mode = v === 'night' || v === 'dark' ? 'night' : v === 'day' || v === 'light' ? 'day' : null;
  var sch = null; try { sch = JSON.parse(localStorage.getItem('petali-id-schedule') || 'null'); } catch (e) { sch = null; }
  function t(x) { var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof x === 'string' ? x.trim() : ''); return m ? +m[1] * 60 + +m[2] : null; }
  var a = sch && t(sch.from), b = sch && t(sch.to);
  if (a === null || b === null || a === b || !sch) { a = 22 * 60; b = 6 * 60; sch = { from: '22:00', to: '06:00' }; }
  var d = new Date(), now = d.getHours() * 60 + d.getMinutes();
  var night;
  if (mode) night = mode === 'night';
  else if (self.PetaliThemeSchedule && self.PetaliThemeSchedule.resolve) night = self.PetaliThemeSchedule.resolve(null, sch, d) === 'night';
  else night = a < b ? now >= a && now < b : now >= a || now < b;
  if (night) document.documentElement.classList.add('night');
  var m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', night ? '#153d52' : '#ebf5e9');
})();
