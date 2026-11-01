// DOM helpers the page's scripts share.

export const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Restarts the one-shot CSS animation that the named class sets on the node.
export function restart(node, name) {
  if (still()) return;
  node.classList.remove(name);
  void node.offsetWidth;
  node.classList.add(name);
}

// An element with its properties and children.
export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
