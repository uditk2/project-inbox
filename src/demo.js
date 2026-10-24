import { insertMessage } from './core.js';
export const demoAccounts = [
  {id:'studio',name:'Studio',mailbox:'hello@studio.example',apiKey:'demo',webhookSecret:'demo'},
  {id:'workshop',name:'Workshop',mailbox:'hello@workshop.example',apiKey:'demo',webhookSecret:'demo'}
];
export async function seedDemo(db) {
  const rows = [
    ['studio','Maya Chen <maya@example.com>','A little hello for your new inbox','Welcome to Project Inbox.\n\nYour projects finally have a place of their own. Read incoming mail, reply from the right address, and keep the rest of your day clear.\n\nThis is sample data. No real mail account is connected.','inbound',0],
    ['workshop','Alex Rivera <alex@example.com>','A question about the next release','Hi there,\n\nI tried the new build this morning. The small details make a difference. Is there a place to follow the next release?\n\nThanks,\nAlex','inbound',0],
    ['studio','Sam Taylor <sam@example.com>','Thanks for sharing your work','Just wanted to say the project looks great. Looking forward to what you build next.\n\nSam','inbound',1],
    ['workshop','hello@workshop.example','Re: A question about the next release','Thanks for trying it! We will share the next release here.','outbound',1]
  ];
  for (let i=0;i<rows.length;i++) {
    const [account,sender,subject,text,direction,read] = rows[i];
    await insertMessage(db,{id:`demo-${i}`,account_id:account,provider_id:`demo-${i}`,direction,sender,recipients:JSON.stringify([demoAccounts.find(a=>a.id===account).mailbox]),subject,body_text:text,body_html:'',headers:'{}',attachments:'[]',message_id:`<demo-${i}@example.com>`,in_reply_to:null,received_at:new Date(Date.now()-i*3600000).toISOString(),is_read:read,archived:0,status:direction==='inbound'?'received':'sent'}).run();
  }
}
