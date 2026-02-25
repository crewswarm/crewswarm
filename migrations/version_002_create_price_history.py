def up():
    with open("price_history.sql", "r") as f:
        db.session.execute(f.read())
    db.session.commit()
