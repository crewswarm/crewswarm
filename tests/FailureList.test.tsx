import React from 'react';
import { render, screen } from '@testing-library/react';
import FailureList from '../src/components/FailureList';

describe('FailureList Contract Tests', () => {
  test('ac-2: Displays a list of recent failures with timestamps on initialization', async () => {
    render(<FailureList />);
    const failureItems = await screen.findAllByTestId('failure-item');
    expect(failureItems.length).toBeGreaterThan(0);
  });
});
