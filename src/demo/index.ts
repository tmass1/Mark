/** The demo's front door. It wants a pointer and a keyboard, which a phone has
 *  not got, so a narrow screen gets a picture of the result instead and loads
 *  none of the frames. The threshold is the site's, which hides its copy of the
 *  demo below the same width.
 *
 *  The choice is made from the width at hand and revisited on resize, one way
 *  only: a frame can be measured before its host has styled it, and a phone can
 *  turn, so a poster may become the demo, but the demo, with a capture in
 *  progress, never becomes a poster. */
const POSTER_BELOW = 640;
let showing: 'poster' | 'page' | null = null;
function choose() {
  const wide = document.documentElement.clientWidth >= POSTER_BELOW;
  if (showing === 'page' || (showing === 'poster' && !wide)) return;
  showing = wide ? 'page' : 'poster';
  document.documentElement.classList.toggle('poster-page', !wide);
  void import(wide ? './page' : './poster');
}
choose();
window.addEventListener('resize', choose);
