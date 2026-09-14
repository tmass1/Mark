/** The demo's front door. It wants a pointer and a keyboard, which a phone has
 *  not got, so a narrow screen gets a picture of the result instead and loads
 *  none of the frames. The threshold is the site's, which hides its copy of the
 *  demo below the same width. */
const POSTER_BELOW = 640;
void (document.documentElement.clientWidth < POSTER_BELOW ? import('./poster') : import('./page'));
