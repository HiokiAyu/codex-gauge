'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const b=fs.readFileSync(path.join(__dirname,'CodexDashboard','assets','app.ico'));
assert.equal(b.readUInt16LE(0),0);assert.equal(b.readUInt16LE(2),1);
const n=b.readUInt16LE(4),sizes=new Set();assert(n>=7);
for(let i=0;i<n;i++){
 const at=6+16*i,w=b[at]||256,h=b[at+1]||256,length=b.readUInt32LE(at+8),offset=b.readUInt32LE(at+12);
 assert.equal(w,h);assert(offset>=6+16*n&&offset+length<=b.length);assert.equal(b.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a');
 assert.equal(b.readUInt32BE(offset+16),w);assert.equal(b.readUInt32BE(offset+20),h);sizes.add(w);
}
for(const n of [16,20,24,32,40,48,64,128,256])assert(sizes.has(n),'Missing icon size '+n);
console.log('Passed: multi-resolution Windows icon contains all required PNG sizes.');
