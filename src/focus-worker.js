import { buildDependencyGraph } from './dependencies.js';
import { buildFocusPlan } from './focus.js';
import { calculateSelection } from './core.js';

let files, graph, projectTokens;
self.onmessage = ({data}) => {
  try {
    if (data.files) {
      files = data.files;
      graph = buildDependencyGraph(files);
      projectTokens = calculateSelection(files, files.map(file => file.id)).tokens;
    }
    if (!graph) throw new Error('Project unavailable');
    const plan = buildFocusPlan(files, graph, data.rootId, data.budget, data.options);
    self.postMessage({requestId:data.requestId, plan, projectTokens});
  } catch {
    files=graph=projectTokens=undefined;
    // Repository content and parser details never appear in UI error messages.
    self.postMessage({requestId:data.requestId, error:true});
  }
};
