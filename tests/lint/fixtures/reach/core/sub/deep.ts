/*
 * The negative control's second file, one directory below the root. It is a
 * core module by every rule in the plugin and it breaks none of them: the
 * offence is one hop away, in a module that is not core and is therefore
 * subject to nothing.
 *
 * A commented-out import sits below the real one on purpose. A walk that
 * scanned raw text rather than code would report it as a second escape, and a
 * control that reported more than the one thing it was written to report would
 * pass a walk that reports everything.
 *
 * THE ONE ESCAPE IS WRITTEN AS A WRAPPED LIST, which is the form five of the
 * thirteen modules under src/core use and the form a one-line pattern cannot
 * see. Written on one line, this control passed against a walk that read no
 * wrapped import at all.
 */

import {
  unseededRoll,
} from '../../shared/unseeded';

// import { alsoNotReal } from '../../shared/commented-out';

export const deepValue = unseededRoll;
