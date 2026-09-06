import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CustomFieldDef } from '../lib/crm-types';
import { CustomFieldsForm, CustomFieldsRenderer } from './custom-fields-renderer';

describe('CustomFieldsRenderer', () => {
  const sampleDefs: CustomFieldDef[] = [
    {
      id: '1',
      entityType: 'contact',
      key: 'nickname',
      label: 'Nickname',
      type: 'text',
      required: false,
      options: {},
    },
    {
      id: '2',
      entityType: 'contact',
      key: 'annual_budget',
      label: 'Annual Budget',
      type: 'currency',
      required: false,
      options: { currency: 'USD' },
    },
    {
      id: '3',
      entityType: 'contact',
      key: 'full_title_upper',
      label: 'Uppercase Title',
      type: 'formula',
      required: false,
      options: { expression: 'UPPER(title)' },
    },
    {
      id: '4',
      entityType: 'contact',
      key: 'vip_status',
      label: 'VIP Status',
      type: 'checkbox',
      required: false,
      options: {},
    },
  ];

  it('renders custom fields and computed formula output with fx badge', () => {
    render(
      <CustomFieldsRenderer
        defs={sampleDefs}
        values={{
          nickname: 'Ace',
          annual_budget: { amount: 50000, currency: 'USD' },
          vip_status: true,
        }}
        computedValues={{
          full_title_upper: 'SENIOR VICE PRESIDENT',
        }}
      />,
    );

    expect(screen.getByText('Nickname')).toBeInTheDocument();
    expect(screen.getByText('Ace')).toBeInTheDocument();

    expect(screen.getByText('Annual Budget')).toBeInTheDocument();
    expect(screen.getByText(/USD 50,000/)).toBeInTheDocument();

    expect(screen.getByText('Uppercase Title')).toBeInTheDocument();
    expect(screen.getByText('SENIOR VICE PRESIDENT')).toBeInTheDocument();
    expect(screen.getByText('fx')).toBeInTheDocument();
  });

  it('respects field-level permission rule none by hiding field completely', () => {
    render(
      <CustomFieldsRenderer
        defs={sampleDefs}
        values={{ nickname: 'Secret' }}
        fieldPermissions={{ nickname: 'none' }}
      />,
    );

    expect(screen.queryByText('Nickname')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret')).not.toBeInTheDocument();
  });

  it('CustomFieldsForm renders editable inputs for non-formula definitions', () => {
    const onChange = vi.fn();
    render(
      <CustomFieldsForm
        defs={sampleDefs}
        values={{ nickname: 'Tester' }}
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText(/Nickname/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Annual Budget/i)).toBeInTheDocument();
    // Formula fields should never be inputs in creation form
    expect(screen.queryByLabelText(/Uppercase Title/i)).not.toBeInTheDocument();
  });
});
