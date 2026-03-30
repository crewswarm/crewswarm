import { render, screen } from '@testing-library/react';
import HealthWidget from '../src/components/HealthWidget';
import useHealthData from '../src/hooks/useHealthData';

// Mocking useHealthData hook
jest.mock('../src/hooks/useHealthData');

describe('HealthWidget', () => {
  it('displays real-time heart rate and steps', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: 72,
      steps: 1000,
      error: null
    });

    render(<HealthWidget />);

    expect(screen.getByText(/Heart Rate: 72/i)).toBeInTheDocument();
    expect(screen.getByText(/Steps: 1000/i)).toBeInTheDocument();
  });

  it('displays error message on data fetch error', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: null,
      steps: null,
      error: new Error('Failed to fetch data')
    });

    render(<HealthWidget />);

    expect(screen.getByText(/Error: Failed to fetch data/i)).toBeInTheDocument();
  });
});
