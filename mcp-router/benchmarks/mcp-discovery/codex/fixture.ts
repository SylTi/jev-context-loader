import {randomUUID} from 'node:crypto';
import type {Task, Call} from './support.js';

const facts:Record<string,string> = {
  'github.search_prs':'auth-migration-pr-42', 'github.update_issue':'Fix the login redirect',
  'linear.list_issue_statuses':'Ready-for-release', 'spaces.get_page_sharing':'reader@example.test',
  'github.get_pr_info':'fixture-author-alice', 'github.fetch_pr':'fixture-author-alice',
  'github.get_pr_diff':'fixture-auth-patch', 'github.fetch_pr_patch':'fixture-auth-patch',
  'github.fetch_commit_workflow_runs':'fixture-ci-run-9001', 'linear.get_project':'Release-Phoenix',
  'linear.list_milestones':'GA-2026-11-15', 'spaces.read_page':'Quarterly-plan-Phoenix',
  'spaces.list_page_automations':'automation-fixture-730', 'github.search_issues':'login-error-issue-81',
  'linear.get_issue':'token-expiry-race-condition', 'linear.list_comments':'Refresh-token-mutex-approved',
  'codex.check_app_update':'up_to_date',
};

export function fixture(task:Task, id:string, args:Record<string,unknown>):Call {
  const group = task.required.find(g => g.includes(id));
  let valid = !!group;
  const values = Object.values(args);
  if (['linear.get_issue','linear.list_comments'].includes(id)) valid &&= values.includes('ENG-123');
  if (['spaces.read_page','spaces.get_page_sharing','spaces.list_page_automations'].includes(id)) valid &&= args.page_id === 'page-example';
  if (['github.get_pr_info','github.get_pr_diff','github.fetch_pr','github.fetch_pr_patch'].includes(id)) valid &&= (values.includes('owner/example') || values.some(v => typeof v === 'string' && v.includes('owner/example'))) && (values.includes(42) || values.some(v => typeof v === 'string' && v.includes('/42')));
  if (id === 'github.update_issue') valid &&= args.title === 'Fix the login redirect' && values.includes(81) && values.includes('owner/example');
  if (id === 'linear.get_project') valid &&= values.includes('project-example');
  if (id === 'linear.list_milestones') valid &&= args.project === 'project-example';
  if (id === 'linear.list_issue_statuses') valid &&= args.team === 'Engineering';
  if (id === 'github.fetch_commit_workflow_runs') valid &&= args.commit_sha === 'abc123fixture' && args.repo_full_name === 'owner/example';
  if (['github.search_prs','github.search_issues'].includes(id)) valid &&= values.some(v => typeof v === 'string' && v.includes('owner/example'));
  return {id,args,valid,receipt:randomUUID(),fact:facts[id] ?? 'unexpected-fixture-call'};
}

export function payload(call:Call):Record<string,unknown> {
  const {id,fact,args}=call;
  const data:Record<string,unknown>={fixtureFact:fact,receipt:call.receipt};
  const specific:Record<string,Record<string,unknown>>={
    'linear.get_issue':{id:'ENG-123',title:'Fix authentication refresh',description:fact,status:'In Progress',attachments:[]},
    'linear.list_comments':{comments:[{id:'comment-1',body:fact,author:'Alice'}]},
    'linear.list_issue_statuses':{statuses:[{id:'status-1',name:fact,team:'Engineering'}]},
    'linear.get_project':{id:'project-example',name:fact,description:'Authentication delivery plan'},
    'linear.list_milestones':{milestones:[{id:'milestone-1',name:fact,projectId:'project-example'}]},
    'spaces.get_page_sharing':{page_id:'page-example',permissions:[{email:fact,role:'reader'}]},
    'spaces.read_page':{page_id:'page-example',title:'Quarterly planning',content:{blocks:[{id:'block-1',kind:'markdown',markdown:fact}]}},
    'spaces.list_page_automations':{page_id:'page-example',automations:[{id:fact,name:'Weekly review',status:'ACTIVE',schedule:'Every Monday at 09:00'}]},
    'github.search_prs':{pull_requests:[{number:42,title:fact,state:'open',repository:'owner/example'}]},
    'github.search_issues':{issues:[{number:81,title:fact,body:'Erreur de connexion',repository:'owner/example'}]},
    'github.update_issue':{number:81,title:args.title,updated:call.valid},
    'github.get_pr_diff':{diff:`diff --git a/auth.ts b/auth.ts\n+// ${fact}\n`},
    'github.fetch_pr_patch':{patch:`diff --git a/auth.ts b/auth.ts\n+// ${fact}\n`},
    'github.fetch_commit_workflow_runs':{workflow_runs:[{id:9001,name:fact,head_sha:'abc123fixture',status:'completed',conclusion:'success'}]},
    'codex.check_app_update':{status:fact,installed_version:'1.0.0',latest_version:'1.0.0'},
  };
  Object.assign(data,specific[id]??{});
  if(id==='github.get_pr_info'||id==='github.fetch_pr')Object.assign(data,{author:fact,draft:false,merged:false,head_sha:'abc123fixture',title:'Authentication migration'});
  if(!call.valid)data.error='Unexpected tool or incorrect fixture arguments; requested action was not applied.';
  return data;
}

