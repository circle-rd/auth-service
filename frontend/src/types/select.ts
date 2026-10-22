import type { Component } from 'vue';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: Component;
  avatar?: { name: string; image?: string | null };
  disabled?: boolean;
}
