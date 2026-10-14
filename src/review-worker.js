import { buildDependencyGraph } from './dependencies.js';
import { parseGitDiff } from './review-diff.js';
import { buildReviewPlan } from './review.js';

let files, graph, rules;
self.onmessage = ({data}) => {
  try {
    if (data.files) {
      files=data.files;rules=data.rules||{};
      graph=buildDependencyGraph(files);
    }
    if (!graph) throw new Error('Project unavailable');
    const parsed=parseGitDiff(data.diff,rules);
    const plan=buildReviewPlan(files,graph,parsed,data.budget,data.options);
    self.postMessage({requestId:data.requestId,plan});
  } catch(error) {
    files=graph=rules=undefined;
    // Only a known diagnostic code may leave the worker; never source text.
    self.postMessage({requestId:data.requestId,error:true,code:typeof error.code==='string'?error.code:undefined});
  }
};
