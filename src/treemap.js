// Balanced slice-and-dice layout: stable, deterministic, and dependency-free.
export function layoutTreemap(items, width, height) {
  const sorted = [...items].filter(item => Number.isFinite(item.weight) && item.weight > 0)
    .sort((a,b) => b.weight - a.weight || String(a.id).localeCompare(String(b.id)));
  const result = [];
  function split(list, x, y, w, h) {
    if (!list.length || w <= 0 || h <= 0) return;
    if (list.length === 1) { result.push({...list[0], x, y, width:w, height:h}); return; }
    const total = list.reduce((sum,item) => sum + item.weight, 0);
    let left = 0, index = 0;
    while (index < list.length - 1 && left < total / 2) { left += list[index++].weight; }
    const fraction = left / total;
    if (w >= h) { split(list.slice(0,index),x,y,w*fraction,h); split(list.slice(index),x+w*fraction,y,w*(1-fraction),h); }
    else { split(list.slice(0,index),x,y,w,h*fraction); split(list.slice(index),x,y+h*fraction,w,h*(1-fraction)); }
  }
  if(Number.isFinite(width) && Number.isFinite(height)) split(sorted,0,0,width,height);
  return result;
}
