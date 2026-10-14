import fs from 'node:fs/promises';
import path from 'node:path';
export async function syntheticWorkspace(root) {
  const dir = 'circuits/electric circuits-7th';
  await fs.mkdir(path.join(root, 'collections', dir), { recursive: true }); await fs.mkdir(path.join(root, dir), { recursive: true });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const cell = source => ({ id: 'example', cell_type: 'code', metadata: {}, source, outputs: [{ output_type: 'stream', name: 'stdout', text: 'Example saved output\n' }], execution_count: 1 });
  const notebook = { nbformat:4, nbformat_minor:5, metadata: { kernelspec: { name:'python3', language:'python', display_name:'Python 3' } }, cells: [
    { id:'heading', cell_type:'markdown', metadata:{}, source:['# 4. Circuit Theorem\n\n![Example](attachment:plot.png)\n\n$E=mc^2$'], attachments:{'plot.png':{'image/png':png}} }, cell(['print(42)']), { ...cell(['value = 1']), id:'last' }
  ] };
  const a = `${dir}/Ch04-circuit theorems.ipynb`; await fs.writeFile(path.join(root, 'collections', a), JSON.stringify(notebook));
  const b = `${dir}/Helper example.ipynb`; await fs.writeFile(path.join(root, 'collections', b), JSON.stringify({ ...notebook, cells:[cell(['from phasor import value\nprint(value)'])] }));
  await fs.writeFile(path.join(root, dir, 'phasor.py'), 'value = 42\n');
  await fs.writeFile(path.join(root, 'collections', dir, 'Ch10-Sinusoidal Steady-State Analysis.ipynb'), JSON.stringify({...notebook, cells: Array.from({length:8},(_,i)=>({...cell(['print(42)']),id:'output-'+i}))}));
  await fs.mkdir(path.join(root, 'collections/toolkit'), { recursive:true });
  const sections = ['# Synthetic long document', ...Array.from({length:18},(_,i) => `## ${i === 9 ? 'Part II — Notes Taken from the Tutorial' : i === 16 ? '17. Use worktrees' : 'Example section ' + (i+1)}\n\n${Array.from({length:14},()=> 'A synthetic paragraph exercises source alignment, wrapping, scrolling, and stable preview rendering. '.repeat(3)).join('\n\n')}\n\n${i < 8 ? '| Example | Value |\n| --- | --- |\n' + '| Synthetic | 42 |\n'.repeat(10) : ''}`)];
  await fs.writeFile(path.join(root, 'collections/toolkit/git-tutorial.md'), sections.join('\n\n'));
  return { version:1, notes:[], attachments:{}, notebookOrigins:{ [a]:dir, [b]:dir } };
}
