import sanitizeHtml from 'sanitize-html';

export function safeMessageHtml(input) {
  return sanitizeHtml(input,{
    allowedTags:['p','div','br','strong','b','em','i','u','s','span','font','ul','ol','li','blockquote','a'],
    allowedAttributes:{'*':['style'],a:['href','title'],font:['face','size','color']},
    allowedSchemes:['http','https','mailto'],
    allowProtocolRelative:false,
    allowedStyles:{'*':{
      'font-family':[/^(Arial|Georgia|monospace|sans-serif|serif|system-ui)(,\s*(Arial|Georgia|monospace|sans-serif|serif|system-ui))*$/i],
      'font-size':[/^(10|12|14|16|18|20|24|28|32)(px|pt)$/,/^(small|medium|large|x-large)$/],
      'font-weight':[/^(normal|bold|[1-9]00)$/],
      'font-style':[/^(normal|italic)$/],
      'text-decoration':[/^(underline|line-through|none)$/],
      'color':[/^#[0-9a-f]{3,8}$/i],
      'text-align':[/^(left|right|center)$/]
    }}
  });
}
