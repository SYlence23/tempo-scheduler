import { spawnSync } from 'node:child_process';
import { pythonExecutable } from './python.mjs';

for (const [command, args] of [[process.execPath,['--test','test/validation.test.mjs']],[pythonExecutable(),['-m','unittest','discover','-s','test','-p','*_test.py','-v']]]) {
  const result=spawnSync(command,args,{cwd:new URL('../',import.meta.url),env:{...process.env,PYTHONUTF8:'1',PYTHONUNBUFFERED:'1'},stdio:'inherit',windowsHide:true});
  if(result.status!==0)process.exit(result.status||1);
}
