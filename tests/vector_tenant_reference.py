"""Source-free vector exact baseline; no Postgres/RLS authority asserted."""
import unittest
import math
def exact(rows,tenant,model,query):
    if not tenant or not model or not query or not all(math.isfinite(x) for x in query):
        raise ValueError('invalid_query')
    qnorm=math.sqrt(sum(x*x for x in query))
    if not qnorm:raise ValueError('zero_vector')
    result=[]
    for row in rows:
        if row['tenant']!=tenant or row['model']!=model:continue
        v=row['embedding']
        if len(v)!=len(query) or not all(math.isfinite(x) for x in v):
            raise ValueError('bad_scoped_embedding')
        length=math.sqrt(sum(x*x for x in v))
        if not length:raise ValueError('bad_zero_embedding')
        result.append((row['id'],sum(a*b for a,b in zip(v,query))/(length*qnorm)))
    return sorted(result,key=lambda e:(-e[1],e[0]))
class TestTenantVector(unittest.TestCase):
    def test_tenant_and_space_isolated_before_score(self):
        rows=[dict(tenant='A',model='v3',id='one',embedding=[1.,0.]),
              dict(tenant='B',model='v3',id='private',embedding=[1.,0.]),
              dict(tenant='A',model='v2',id='old',embedding=[1.,0.])]
        self.assertEqual([x[0] for x in exact(rows,'A','v3',[1.,0.])],['one'])
    def test_poisoned_unrelated_tenant_does_not_break_query(self):
        rows=[dict(tenant='B',model='v3',id='bad',embedding=[math.nan,0.])]
        self.assertEqual(exact(rows,'A','v3',[1.,0.]),[])
    def test_nonfinite_and_zero_rejected(self):
        with self.assertRaises(ValueError):exact([],'A','v3',[math.inf])
        with self.assertRaises(ValueError):exact([],'A','v3',[0.])
if __name__=='__main__':unittest.main()
