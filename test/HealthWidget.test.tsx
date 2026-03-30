import { render, screen } from '@testing-library/react';
import HealthWidget from '../src/components/HealthWidget';
import useHealthData from '../src/hooks/useHealthData';

// Mocking useHealthData hook
jest.mock('../src/hooks/useHealthData');

describe('HealthWidget Contract Tests', () => {
  test('ac-1: Given user profile data, When HealthWidget is rendered, Then display real-time health metrics', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: 72,
      steps: 1000,
      calories: 200,
      error: null
    });

    render(<HealthWidget />);

    expect(screen.getByText(/Heart Rate: 72/i)).toBeInTheDocument();
    expect(screen.getByText(/Steps: 1000/i)).toBeInTheDocument();
    expect(screen.getByText(/Calories: 200/i)).toBeInTheDocument();
  });

  test('ac-3: Given abnormal heart rate data, When HealthWidget processes data, Then trigger alert', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: 150, // Assuming 150 is considered abnormal
      steps: 1000,
      calories: 200,
      error: null
    });

    render(<HealthWidget />);

    expect(screen.getByText(/Alert: Abnormal Heart Rate/i)).toBeInTheDocument();
  });

  it('displays error message on data fetch error', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: null,
      steps: null,
      calories: null,
      error: new Error('Failed to fetch data')
    });

    render(<HealthWidget />);

    expect(screen.getByText(/Error: Failed to fetch data/i)).toBeInTheDocument();
  });
});
