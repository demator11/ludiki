const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
const copy=vm.runInNewContext(fs.readFileSync(path.join(root,'static/copy.js'),'utf8')+';Copy');
const rows=JSON.parse(fs.readFileSync(path.join(root,'static/text-catalog.json'),'utf8'));
copy.init(rows);
for(const row of rows){
  const sample=row.default.replace(/\{([a-z_]+)\}/g,(_,key)=>'731');
  const found=copy.match(sample);
  assert(found,`No match: ${row.default}`);
  // Specific static labels take precedence over general patterns.
  if(found.row.id===row.id){
    assert.equal(copy.text(sample,{[row.id]:'NEW '+row.default}),'NEW '+sample);
  }
}
const coin=rows.find(r=>r.default==='Орёл');
copy.set({[coin.id]:'<b>Сторона A</b> & слово'});
assert.equal(copy.text('  Орёл  '),'  <b>Сторона A</b> & слово  ');
assert.equal(copy.text('Неизвестная пользовательская строка'),'Неизвестная пользовательская строка');
const generation=copy.generation;copy.set({[coin.id]:'<b>Сторона A</b> & слово'});assert.equal(copy.generation,generation);
copy.set({});assert.equal(copy.generation,generation+1);assert.equal(copy.text('Орёл'),'Орёл');
console.log(`Text catalog: ${rows.length} labels, dynamic substitution, reset and update generation passed.`);
