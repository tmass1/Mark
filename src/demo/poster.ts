/** What a phone sees in the demo's place: the editor over a marked-up capture,
 *  and where to go to try the real thing. */
import './page.css';
document.documentElement.classList.add('poster-page');
document.body.innerHTML = `
  <figure class="poster">
    <img src="./site/hero.png" width="938" height="564" alt="Mark’s editor over a captured dashboard: a red box around the repeat-rate card, an arrow at the chart’s peak with the note “Launch day”, and the revenue figure redacted into coarse blocks." />
    <figcaption>This is Mark’s editor. The demo behind this picture wants a pointer and a keyboard — open this page on a Mac to try it.</figcaption>
  </figure>`;
