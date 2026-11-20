import React from 'react';
import portrait from './docs/assets/avatar-pixel-icon.png';

// Product artwork only. Names, personality and relationships still come from
// the active Human configuration; this component never changes model prompts.
export function HumanAvatar({size=40}: {size?:number}) {
  return <img src={portrait} alt="" aria-hidden="true" draggable={false}
    width={size} height={size} style={{display:'block',width:size,height:size,objectFit:'contain',background:'transparent',flexShrink:0}}/>;
}
