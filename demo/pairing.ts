// Select this function and ask your pair to simplify it.
// Keep typing while it thinks; proposals never overwrite your work automatically.
export function summarize(items: { title: string; done: boolean }[]) {
  const completed = [];
  for (let index = 0; index < items.length; index++) {
    if (items[index].done === true) {
      completed.push(items[index].title);
    }
  }
  return completed.join(", ");
}

console.log(summarize([{ title: "Start pairing", done: true }]));
