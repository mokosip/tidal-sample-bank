// Leading + trailing throttle: the first call goes out at once, later calls inside
// the window collapse into one trailing call with the most recent arguments.
// Consecutive sends are always at least `ms` apart.
export function throttle(fn, ms) {
  let timer = null;
  let pending = null;
  const open = () => {
    timer = setTimeout(() => {
      if (pending) {
        const args = pending;
        pending = null;
        fn(...args);
        open();
      } else {
        timer = null;
      }
    }, ms);
  };
  return (...args) => {
    if (timer === null) {
      fn(...args);
      open();
    } else {
      pending = args;
    }
  };
}
