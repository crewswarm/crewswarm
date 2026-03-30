import React from 'react';
import { render, screen } from '@testing-library/react';
import AgentHealthWidget from '../src/components/AgentHealthWidget';

describe('AgentHealthWidget Contract Tests', () => {
  test('ac-1: Displays current agent health status on initialization', async () => {
    render(<AgentHealthWidget />);
    const healthStatus = await screen.findByTestId('agent-health-status');
    expect(healthStatus).toBeInTheDocument();
  });
});
