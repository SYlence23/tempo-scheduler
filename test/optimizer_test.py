import copy
import math
import unittest
from backend.python.optimizer import optimize, validate_input

def fixture():
    return {'name': 'Sprint', 'resources': [{'id':'a','name':'Anna'},{'id':'b','name':'Bohdan'}], 'tasks': [{'id':'design','duration':3,'deadline':5,'dependencies':[],'eligibleResources':['a']},{'id':'api','duration':4,'deadline':6,'dependencies':[]},{'id':'ui','duration':2,'deadline':7,'dependencies':['design']},{'id':'qa','duration':2,'deadline':9,'dependencies':['api','ui']}], 'iterations':5000,'seed':21}

class OptimizerTests(unittest.TestCase):
    def test_validation_rejects_cycles_unknown_references_and_limits(self):
        data=fixture()
        data['tasks'][0]['dependencies']=['qa']
        with self.assertRaisesRegex(ValueError,'цикл'):
            validate_input(data)
        data=fixture()
        data['tasks'][0]['eligibleResources']=['missing']
        with self.assertRaisesRegex(ValueError,'невідомого'):
            validate_input(data)
        data=fixture()
        data['tasks'][1]['dependencies']=['missing']
        with self.assertRaisesRegex(ValueError,'невідомої'):
            validate_input(data)
        with self.assertRaises(ValueError):
            validate_input(dict(fixture(),iterations=2000001))

    def test_schedule_respects_dependencies_resources_and_exclusivity(self):
        data=validate_input(fixture())
        result=optimize(data)
        self.assertLessEqual(result['optimized']['score'],result['baseline']['score'])
        for plan in (result['baseline'],result['optimized']):
            by_id={row['taskId']:row for row in plan['schedule']}
            for task in data['tasks']:
                row=by_id[task['id']]
                self.assertAlmostEqual(row['end']-row['start'],task['duration'])
                self.assertIn(row['resourceId'],task['eligibleResources'])
                for dependency in task['dependencies']:
                    self.assertGreaterEqual(row['start'],by_id[dependency]['end'])
            for resource in data['resources']:
                rows=sorted((row for row in plan['schedule'] if row['resourceId']==resource['id']),key=lambda row:row['start'])
                for previous,current in zip(rows,rows[1:]):
                    self.assertGreaterEqual(current['start'],previous['end'])

    def test_seed_is_reproducible_and_best_score_never_deteriorates(self):
        first,second=optimize(fixture()),optimize(fixture())
        self.assertEqual(first['optimized'],second['optimized'])
        self.assertEqual(first['convergence'],second['convergence'])
        scores=[row['score'] for row in first['convergence']]
        self.assertTrue(all(after<=before for before,after in zip(scores,scores[1:])))

    def test_cancellation_stops_computation(self):
        with self.assertRaisesRegex(RuntimeError,'TASK_CANCELLED'):
            optimize(fixture(),is_cancelled=lambda:True)
        cancelled=False
        def progress(value,stage):
            nonlocal cancelled
            if value>10:
                cancelled=True
        with self.assertRaisesRegex(RuntimeError,'TASK_CANCELLED'):
            optimize(fixture(),on_progress=progress,is_cancelled=lambda:cancelled)

    def test_improves_poor_greedy_schedule(self):
        data={'resources':[{'id':'a'},{'id':'b'}],'tasks':[{'id':'short','duration':2,'deadline':100},{'id':'long','duration':10,'deadline':100,'eligibleResources':['a']},{'id':'followup','duration':3,'deadline':100,'dependencies':['long']}],'iterations':10000,'seed':42}
        result=optimize(data)
        self.assertLess(result['optimized']['score'],result['baseline']['score'])

    def test_fractional_hours_have_finite_exact_metrics(self):
        data=fixture()
        data['tasks'][0]['duration']=.0001
        with self.assertRaises(ValueError):
            validate_input(data)
        data=fixture()
        for task,duration in zip(data['tasks'],[.001,.12345,.3,.7]):
            task['duration']=duration
        data=validate_input(data)
        self.assertEqual(data['tasks'][1]['duration'],.123)
        result=optimize(data)
        self.assertTrue(math.isfinite(result['improvementPercent']))
        self.assertTrue(all(math.isfinite(row['utilization']) for row in result['resourceUtilization']))
        self.assertAlmostEqual(result['optimized']['score'],result['optimized']['makespan']+2*result['optimized']['tardiness'])

if __name__=='__main__':
    unittest.main()
