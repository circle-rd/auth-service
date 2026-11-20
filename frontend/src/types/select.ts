import type { Component } from 'vue';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  /** Options sharing a group are listed under one header; consecutive options only. */
  group?: string;
  icon?: Component;
  /** Short text rendered in the icon slot (for example a flag emoji). */
  iconText?: string;
  avatar?: { name: string; image?: string | null };
  disabled?: boolean;
}
