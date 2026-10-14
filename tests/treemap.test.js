import {test} from 'node:test';
import assert from 'node:assert/strict';
import {layoutTreemap} from '../src/treemap.js';
test('treemap covers the available area with non-overlapping proportional tiles',()=>{
 const tiles=layoutTreemap([{id:'a',weight:60},{id:'b',weight:30},{id:'c',weight:10}],600,300);
 assert.equal(tiles.length,3);
 for(const tile of tiles){assert.ok(tile.width>0&&tile.height>0);assert.ok(tile.x>=0&&tile.y>=0&&tile.x+tile.width<=600.00001&&tile.y+tile.height<=300.00001);assert.ok(Math.abs(tile.width*tile.height/180000-tile.weight/100)<1e-8);}
 for(let i=0;i<tiles.length;i++)for(let j=i+1;j<tiles.length;j++){const a=tiles[i],b=tiles[j];assert.ok(a.x+a.width<=b.x+1e-8||b.x+b.width<=a.x+1e-8||a.y+a.height<=b.y+1e-8||b.y+b.height<=a.y+1e-8);}
});
test('treemap is stable under input reordering and ignores invalid weights',()=>{
 const data=[{id:'z',weight:4},{id:'a',weight:4},{id:'b',weight:1}];
 assert.deepEqual(layoutTreemap(data,300,600),layoutTreemap([...data].reverse(),300,600));
 assert.deepEqual(layoutTreemap([{id:'bad',weight:NaN},{id:'zero',weight:0}],300,600),[]);
 assert.deepEqual(layoutTreemap(data,0,300),[]);
});
