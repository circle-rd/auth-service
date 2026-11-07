import type { Component } from 'vue';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: Component;
  /** Short text rendered in the icon slot (for example a flag emoji). */
  iconText?: string;
  avatar?: { name: string; image?: string | null };
  disabled?: boolean;
}
