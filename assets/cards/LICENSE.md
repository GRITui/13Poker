# Playing-card art: license and attribution

All card images in this directory (`*.svg`) come from the
**Vectorized Playing Cards 1.3** graphics library.

    Vectorized Playing Cards 1.3 - http://code.google.com/p/vectorized-playing-cards/
    Copyright 2011 - Chris Aguilar
    Licensed under LGPL 3 - www.gnu.org/copyleft/lesser.html

- **Author:** Chris Aguilar (webmaster@totalnonsense.com)
- **Original project:** http://code.google.com/p/vectorized-playing-cards/
  (archived at https://code.google.com/archive/p/vectorized-playing-cards/)
- **License:** GNU Lesser General Public License, version 3 or (at your option)
  any later version (LGPL-3.0-or-later). The full license texts are included
  next to this file: [`COPYING.LESSER.txt`](COPYING.LESSER.txt) (LGPL v3) and
  [`COPYING.txt`](COPYING.txt) (GPL v3, which the LGPL builds on).
- **Obtained from:** the `cardsJS` npm package, version 1.1.1
  (https://www.npmjs.com/package/cardsJS, https://github.com/richardschneider/cardsJS,
  MIT-licensed code by Richard Schneider), file set `cards/`. cardsJS ships the
  Vectorized Playing Cards 1.3 SVGs, adjusted to fit-to-size instead of an A4 page.

## Modifications made for 13Poker

As required by the LGPL, the changes made to the original files are listed here:

1. Renamed to `{rank}{suit}.svg` (rank `2-9,T,J,Q,K,A`; suit `c,d,h,s`), e.g.
   `AS.svg` -> `As.svg`, `10D.svg` -> `Td.svg`. `Blue_Back.svg` -> `back.svg`,
   `Red_Back.svg` -> `back-alt.svg`.
2. Removed Inkscape/Sodipodi editor metadata (`<metadata>`, `<sodipodi:namedview>`,
   `inkscape:*` / `sodipodi:*` attributes, comments). No drawing content was changed.
3. Added a `viewBox` to every root `<svg>` so the cards scale to any CSS size, and
   gave the two backs the same box size as the faces (224.22508 x 312.80777),
   centring their slightly smaller artwork.

`preview.html` is a 13Poker test page, not part of the card library.
