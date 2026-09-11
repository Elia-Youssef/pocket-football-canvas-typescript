/*
 * The module outside the boundary that the two files beside this directory
 * reach. It is not a core path, so no rule in the plugin has an opinion about
 * it, which is precisely the point being made: the offence is legal where it is
 * written and illegal in what depends on it.
 */

export function unseededRoll(): number {
  return Math.random();
}
