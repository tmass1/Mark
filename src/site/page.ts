/** The guide to AI tools. The page is written in ai.html; this fills in what the app itself knows.
 *  The mark is the artwork in brand/, shown as it is. */
import './page.css';
import markIcon from '../mark-icon.png';
import { copyButtons, showAppFacts } from './facts';

for (const rel of ['icon', 'apple-touch-icon']) {
  document.head.append(Object.assign(document.createElement('link'), { rel, href: markIcon }));
}
showAppFacts();
copyButtons();
