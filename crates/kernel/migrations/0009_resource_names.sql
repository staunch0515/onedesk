-- 0009 (review #6): `[[name]]` resolution looks resources up by name; 0008 is published and stays.
CREATE INDEX resources_name ON resources (name);
