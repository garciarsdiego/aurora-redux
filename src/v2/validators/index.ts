import { validateCode } from './code.js';
import { validateContent } from './content.js';
import { validateData } from './data.js';
import { validateAnalysis } from './analysis.js';

export type ValidatorResult = { passed: boolean; message: string };
export type ValidatorFn = (output: string) => ValidatorResult;
export type ValidatorProfile = 'code' | 'content' | 'data' | 'analysis' | 'none';

export { validateCode, validateContent, validateData, validateAnalysis };

export function getValidator(profile: ValidatorProfile = 'code'): ValidatorFn | null {
  switch (profile) {
    case 'code':     return validateCode;
    case 'content':  return validateContent;
    case 'data':     return validateData;
    case 'analysis': return validateAnalysis;
    case 'none':     return null;
    default:         return validateCode;
  }
}
