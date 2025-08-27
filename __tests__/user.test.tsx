 // biome-ignore lint/correctness/noUnusedImports: needed for JSX
import React from 'react';
import { render, screen } from '@testing-library/react';
import UserAppPage from '../src/app/user/page';
import '@testing-library/jest-dom';

test('renders user app page', () => {
  render(<UserAppPage />);
  expect(screen.getByText('User App')).toBeInTheDocument();
});
