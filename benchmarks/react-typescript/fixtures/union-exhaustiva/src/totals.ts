export type Event =
  | { kind: 'add'; amount: number }
  | { kind: 'refund'; amount: number }
  | { kind: 'void' };

function applyEvent(total: number, event: Event): number {
  switch (event.kind) {
    case 'add': return total + event.amount;
    case 'refund': return total - event.amount;
  }
}

export function netTotal(events: Event[]): number {
  return events.reduce(applyEvent, 0);
}
