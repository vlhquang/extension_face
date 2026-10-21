export function postKey(campaign, post) {
  if (!post.url) throw new Error(`Post in ${campaign.id} is missing its URL.`);
  const url = new URL(post.url);
  url.search = '';
  url.hash = '';
  if (url.hostname.endsWith('.facebook.com')) url.hostname = 'www.facebook.com';
  return `${campaign.id}:${url.href.replace(/\/$/, '')}`;
}

export function buildPayload(campaign, post, title) {
  const hashtags = [...new Set(campaign.description.match(/#[\p{L}\p{N}_]+/gu) || [])].join(' ');
  const content = [
    post.url,
    hashtags,
    post.score?.text ?? '',
    'Doanh nghiệp: #ILoveHDBank #HDBank #DongHanhCungDoanhNghiep',
    'Thẻ: #ILoveHDBank #HDBank #AppHDBank #TheHDBank',
    'Vay: #ILoveHDBank #HDBank #VayHDBank #HappyDigitalBank',
    'Tự hào: #ILoveHDBank #HDBank #HappyDigitalBank',
  ];
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        type: 'AdaptiveCard', version: '1.2',
        body: [
          { type: 'TextBlock', wrap: true, style: 'heading', text: title ?? hashtags },
          ...content.map((text, index) => ({ type: 'TextBlock', text, wrap: true, separator: index === 0 })),
        ],
        actions: [
          { type: 'Action.OpenUrl', title: 'M\u1edf b\u00e0i vi\u1ebft', url: post.url },
          ...(post.source === 'https://www.facebook.com/hdbankfanpage' ? [
            { type: 'Action.OpenUrl', title: 'M\u1edf fanpage HDBank', url: post.source },
          ] : []),
        ],
      },
    }],
  };
}

export async function sendNotification(webhook, payload) {
  let response;
  try {
    response = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Webhook request failed or timed out; post remains pending.');
  }
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}; post remains pending.`);
}
