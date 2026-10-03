import fs from 'node:fs/promises';
import {quotaReport} from '../src/saas/quota-report.mjs';
try{
  const args=process.argv.slice(2),index=args.indexOf('--file');
  if(index<0||!args[index+1]||args.length!==2)throw new Error('usage');
  const input=JSON.parse(await fs.readFile(args[index+1],'utf8'));
  console.log(JSON.stringify(quotaReport(input),null,2));
}catch{
  console.error('Provide --file with cost evidence and budget JSON. No quotas were configured.');
  process.exitCode=1;
}
