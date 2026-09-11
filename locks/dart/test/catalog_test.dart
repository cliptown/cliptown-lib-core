import 'package:cliptown_locks/cliptown_locks.dart';
import 'package:test/test.dart';

void main() {
  test('keys carry the org prefix', () {
    expect(key(Domain.jobs, 'x').value, 'cliptown/jobs/x');
  });

  test('placeholders are filled in order', () {
    const entry = Entry(
      domain: Domain.jobs,
      name: '{a}/x/{b}',
      layers: LockLayers.both,
      pgScope: PgScope.transaction,
      wait: true,
    );
    expect(entry.key(['1', '2']).value, 'cliptown/jobs/1/x/2');
    expect(entry.plan.steps.first, LockStep.fiduciaAcquire);
  });
}
