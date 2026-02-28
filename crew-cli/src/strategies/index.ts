import { applyPatch } from 'diff';

export interface EditStrategy {
  name: string;
  apply(original: string, change: string): string;
}

export class WholeFileStrategy implements EditStrategy {
  name = 'whole-file';
  apply(original: string, change: string): string {
    return change;
  }
}

/**
 * Aider-style Search/Replace Blocks
 */
export class SearchReplaceStrategy implements EditStrategy {
  name = 'search-replace';
  
  apply(originalContent: string, changePayload: string): string {
    const lines = changePayload.split('\n');
    let currentContent = originalContent;
    
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() === '<<<<<< SEARCH') {
        const searchStart = i + 1;
        let searchEnd = -1;
        let replaceEnd = -1;
        
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '======') {
            searchEnd = j;
          } else if (lines[j].trim() === '>>>>>> REPLACE') {
            replaceEnd = j;
            break;
          }
        }
        
        if (searchEnd !== -1 && replaceEnd !== -1) {
          const searchBlock = lines.slice(searchStart, searchEnd).join('\n');
          const replaceBlock = lines.slice(searchEnd + 1, replaceEnd).join('\n');
          
          if (searchBlock.trim() === '') {
            // Append if search is empty (or handle at start)
            currentContent += replaceBlock;
          } else if (currentContent.includes(searchBlock)) {
            currentContent = currentContent.replace(searchBlock, replaceBlock);
          } else {
            // Fallback: try fuzzy or just ignore?
            // For now, throw to signal failure
            throw new Error('Search block not found in content.');
          }
          i = replaceEnd + 1;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    
    return currentContent;
  }
}

/**
 * Unified Diff format using 'diff' library
 */
export class UnifiedDiffStrategy implements EditStrategy {
  name = 'unified-diff';
  apply(original: string, diff: string): string {
    const result = applyPatch(original, diff);
    if (result === false) {
      throw new Error('Failed to apply unified diff patch.');
    }
    return result;
  }
}

export function getStrategy(name: string): EditStrategy {
  switch (name) {
    case 'whole-file': return new WholeFileStrategy();
    case 'search-replace': return new SearchReplaceStrategy();
    case 'editblock': return new SearchReplaceStrategy(); // Alias
    case 'unified-diff': return new UnifiedDiffStrategy();
    default: return new WholeFileStrategy();
  }
}
