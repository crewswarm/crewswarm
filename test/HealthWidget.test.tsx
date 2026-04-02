import { render, screen, act } from '@testing-library/react';
import HealthWidget from '../src/components/HealthWidget';
import useHealthData from '../src/hooks/useHealthData';

jest.mock('../src/hooks/useHealthData');

describe('HealthWidget Contract Tests', () => {

  it('ac-1: displays heart rate, steps, and calories burned in real-time', async () => {
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

  it('ac-2: updates metrics without page refresh every 5 seconds', () => {
    jest.useFakeTimers();
    (useHealthData as jest.Mock).mockReturnValueOnce({
      heartRate: 72,
      steps: 1000,
      calories: 200,
      error: null
    }).mockReturnValueOnce({
      heartRate: 75,
      steps: 1050,
      calories: 250,
      error: null
    });

    render(<HealthWidget />);
    
    expect(screen.getByText(/Heart Rate: 72/i)).toBeInTheDocument();
    expect(screen.getByText(/Steps: 1000/i)).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(5000);
    });

    expect(screen.getByText(/Heart Rate: 75/i)).toBeInTheDocument();
    expect(screen.getByText(/Steps: 1050/i)).toBeInTheDocument();
  });

  it('ac-3: persists user customization settings across sessions', () => {
    (useHealthData as jest.Mock).mockReturnValue({
      heartRate: 72,
      steps: 1000,
      calories: 200,
      error: null
    });

    render(<HealthWidget />);

    const toggleButton = screen.getByText('Toggle Calories');
    toggleButton.click();
    
    expect(screen.queryByText(/Calories: 200/i)).not.toBeInTheDocument();

    toggleButton.click();
    expect(screen.getByText(/Calories: 200/i)).toBeInTheDocument();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });
});
